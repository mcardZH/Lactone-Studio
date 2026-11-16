import type { BondPerceptionMode, ChemistryJob, ChemistryPort, ChemistryResult, ModelDocument, ModelStore, ScientificModelOperation } from '../contracts';
import { effectiveModelConstraints } from '../constraints';
import { bondOrderObservation, periodicBondOrderConnections, validateBondOrderEvidence } from '../bond-orders';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import { perceivePeriodicConnections } from '../../core/periodic';
import type { XtbBondOrders, XtbBridge, XtbCoordinateResult, XtbEvent, XtbMetadata, XtbMethod, XtbRequest, XtbPreviewFrame, XtbOptimizationScope } from './contracts';
import { XTB_METHOD_LABELS } from './contracts';
import { applyXtbCoordinates, applyXtbStoppedCoordinates, validateXtbPeriodicity, xtbOptimizationStepKind, xtbPreoptimizationSolvationIssue, type XtbPreoptimizationSolvation } from './accept-result';
import { supportsXtbOperation } from '../../core/xtb-capabilities';
import {coordinatesFingerprint} from '../../core/modeling/graph';
import { empiricalBondAdmission } from '../empirical-bond-admission';
import {runtimePreviewSourceCurrent} from '../../core/modeling/runtime-source-lineage';

export interface XtbOptions { method: XtbMethod; charge: number; multiplicity: number; rebuildBonds: boolean; threads?: number; maxSteps?: number; maxSccIterations?: number; maxWallTimeSeconds?: number; scope?: XtbOptimizationScope; empiricalBondParameters?:EmpiricalBondPerceptionParameters; solvation?:XtbPreoptimizationSolvation; ffModel?:XtbRequest['ffModel'] }
export interface XtbRunObserver {
  /** Caller owns final scientific adoption; the runtime keeps its scratch document isolated. */
  deferApplication?: true;
  onStart(request:XtbRequest,sessionId:string):void;
  onEvent?(event:XtbEvent):void;
  onSettled(value:{request:XtbRequest;sessionId:string;status:'completed'|'stopped'|'failed';frames:readonly XtbPreviewFrame[];result?:XtbCoordinateResult;document?:ModelDocument;error?:string}):void;
}
/** Capture a variable set only; the native calculation retains the complete
 * molecule and its electronic state. Scope never changes persistent freezes. */
export function xtbOptimizationMovableAtomIds(document:ModelDocument,scope:XtbOptimizationScope='all'):string[]{
  if(!['all','selection','unselected'].includes(scope))throw new Error('未知xTB优化范围。');
  const fixed=new Set(effectiveModelConstraints(document).frozenAtomIds),selected=new Set(document.selection.atomIds);
  return document.draft.structure.atoms.flatMap(atom=>!fixed.has(atom.id!)&&(scope==='all'||(scope==='selection'?selected.has(atom.id!):!selected.has(atom.id!)))?[atom.id!]:[]);
}
export interface XtbState { running: boolean; phase: 'idle' | 'optimizing' | 'playing' | 'bonding' | 'stopping'; operation?:'optimize'|'singlepoint'|'perceive-bonds'; status: string; error: string; metadata?: XtbMetadata; previewFrame?: XtbPreviewFrame; previewSkippedFrames?: number; retainedResult?: XtbCoordinateResult; retainedStoppedFrame?: XtbPreviewFrame; retainedBondResult?: ChemistryResult; canContinue?:boolean; continuationMethod?:XtbMethod; sourceChain?:string[]; trajectoryFrames?:XtbPreviewFrame[]; workingSource?: { documentId: string; revision: number } }
export interface XtbControllerDependencies {
  store: ModelStore; bridge: Partial<XtbBridge> | null; chemistry: ChemistryPort;
  /** Enabled only where the working viewport is isolated from task previews. */
  allowWorkingEdits?: true;
  captureSource?(): ModelDocument;
  confirmConstraints(): boolean;
  assertCurrent(): void;
}
const initialState = (): XtbState => ({ running: false, phase: 'idle', status: '', error: '' });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const XTB_PLAYBACK_INTERVAL_MS = 16;
export const XTB_PLAYBACK_MAX_TAIL_MS = 750;
export const XTB_PLAYBACK_MAX_QUEUED_FRAMES = 48;
export const XTB_PLAYBACK_MAX_QUEUED_COORDINATES = 24000;
interface Playback {
  sessionId: string; request: XtbRequest; queue: XtbPreviewFrame[];
  timer?: ReturnType<typeof setTimeout>; lastStep: number; completed: boolean;
  resolve?: () => void; reject?: (error: Error) => void;
}
interface XtbContinuation {
  options: XtbOptions;
  source: ModelDocument;
  sourceChain: string[];
  trajectoryFrames: XtbPreviewFrame[];
}
const continuations = new WeakMap<ModelStore, XtbContinuation>();

/** Frame validation does not apply coordinates or require optimizer convergence. */
function validatePreviewFrame(event: XtbEvent, request: XtbRequest, lastStep: number): XtbPreviewFrame {
  if (request.calculation === 'singlepoint' || event.stepKind !== xtbOptimizationStepKind(request,event.periodic) || !Number.isSafeInteger(event.step) || event.step! < 0 || event.step! <= lastStep || !Array.isArray(event.coordinates) || event.coordinates.length !== request.structure.atoms.length || event.energyHartree!==undefined&&!Number.isFinite(event.energyHartree)) throw new Error('xTB原生帧类型、序号、能量或原子数量无效。');
  if(event.stepKind==='native-fire-cycle'&&event.step!>(request.maxSteps??1000))throw new Error('原生FIRE轨迹超出请求步数。');
  validateXtbPeriodicity(request,event.periodic);
  const fixed = new Set(request.frozenAtomIds);
  event.coordinates.forEach((point, index) => {
    const original = request.structure.atoms[index];
    if (!point || point.id !== original.id || point.element !== original.element || ![point.x,point.y,point.z].every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) throw new Error('xTB原生帧身份、顺序或坐标无效。');
    if (fixed.has(point.id) && ![point.x,point.y,point.z].every((value, axis) => Object.is(value, original[(['x','y','z'] as const)[axis]]))) throw new Error('xTB原生帧改变了冻结原子坐标。');
  });
  return { sessionId:event.sessionId, stamp:structuredClone(event.stamp), seq:event.seq, step:event.step!, stepKind:event.stepKind, coordinates:structuredClone(event.coordinates),...(event.periodic?{periodic:structuredClone(event.periodic)}:{}),...(event.energyHartree===undefined?{}:{energyHartree:event.energyHartree}) };
}

/** A single document-owned operation: real xTB result, then optional existing bond perception. */
export class XtbController {
  private state = initialState();
  private listeners = new Set<() => void>();
  private sessionId?: string;
  private cancelRequested = false;
  private chemistryJob?: ChemistryJob;
  private gone = false;
  private unsubscribe?: () => void;
  private rejectPending?: (error: Error) => void;
  private playback?: Playback;
  private lastReliableFrame?:XtbPreviewFrame;
  private nativeClosed=false;
  private nativeIssued=false;
  private continuing?:XtbContinuation;
  private getContinuation(){
    const pending=continuations.get(this.deps.store);
    return pending&&runtimePreviewSourceCurrent(pending.source,this.deps.store.getSnapshot())?pending:undefined;
  }
  async continueOptimization(maxSteps?:number,maxSccIterations?:number){
    const pending=this.getContinuation(),document=this.deps.store.getSnapshot();
    if(!pending||this.state.running)throw Error('继续优化的结构已变化，请重新启动优化。');
    const solvationIssue=xtbPreoptimizationSolvationIssue(pending.options.method,pending.options.solvation,Boolean(document.draft.structure.cell));
    if(solvationIssue)throw new Error(solvationIssue);
    this.continuing=pending;
    try{await this.run({...pending.options,...(maxSteps===undefined?{}:{maxSteps}),...(maxSccIterations===undefined?{}:{maxSccIterations})});}
    finally{this.continuing=undefined;}
  }
  private rememberContinuation(options:XtbOptions,target=this.deps.store){
    this.bindContinuation(target,structuredClone({options,sourceChain:this.state.sourceChain??[],trajectoryFrames:this.state.trajectoryFrames??[]}));
  }
  private bindContinuation(target:ModelStore,continuation:Omit<XtbContinuation,'source'>){
    continuations.set(target,{...continuation,source:target.getSnapshot()});
    if(target===this.deps.store)this.update({canContinue:true});
  }
  private runSettled?:Promise<void>;
  private stopTask?:Promise<unknown>;
  private sourceDocument?: ModelDocument;
  private ownerDocument?: ModelDocument;
  private scientificOperation?: ScientificModelOperation;
  private perceptionDetached = false;
  getWorkingSourceDocument=()=>this.sourceDocument;
  getWorkingOwnerDocument=()=>this.ownerDocument;
  private previewSourceStillCurrent(){return (this.scientificOperation?.isCurrent()??runtimePreviewSourceCurrent(this.sourceDocument,this.deps.store.getSnapshot()))&&this.runtimeOwnerCurrent();}
  private runtimeOwnerCurrent(){try{this.deps.assertCurrent();return true;}catch{return false;}}
  private sourceStillCurrent() { const now=this.deps.store.getSnapshot(),source=this.sourceDocument;return !!source&&now.id===source.id&&now.revision===source.revision&&now.analysisBindingId===source.analysisBindingId&&this.runtimeOwnerCurrent(); }
  private stopAcknowledgement():Promise<unknown>|undefined{return this.stopTask;}
  constructor(private readonly deps: XtbControllerDependencies) {}
  getSnapshot = () => {
    const continuation=this.state.running?undefined:this.getContinuation(),canContinue=!!continuation;
    const continuationMethod=canContinue?continuation?.options.method:undefined;
    if(Boolean(this.state.canContinue)!==canContinue||this.state.continuationMethod!==continuationMethod)this.state={...this.state,canContinue,continuationMethod};
    return this.state;
  };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<XtbState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  connect() { this.gone = false; }
  disconnect() { this.gone = true; void this.stop().catch(()=>{}); this.rejectPending?.(new Error('xTB运行视图已关闭。')); }
  async stop() {
    if (!this.state.running) return;
    if(this.state.phase==='stopping'){await this.runSettled;return;}
    const previousPhase=this.state.phase;
    this.cancelRequested = true; this.update({ phase: 'stopping', status: '正在停止xTB…' });
    const stopped = new Error('已停止xTB。');
    this.clearPlayback(stopped,true);
    this.chemistryJob?.cancel();
    if (this.sessionId&&this.nativeIssued) {
      let failed=false;
      this.stopTask=Promise.resolve(this.deps.bridge?.commandXtb?.(this.sessionId, { command: 'stop' })).catch(error=>{if(!this.nativeClosed){failed=true;this.update({phase:previousPhase,status:'停止请求失败，后台尚未确认停止。',error:error instanceof Error?error.message:String(error)});}});
      await this.stopTask;
      if(failed)return;
    }
    await this.runSettled;
  }
  private retainStoppedFrame(request:XtbRequest,options:XtbOptions):boolean{
    if(this.gone)throw new Error('xTB运行视图已关闭，停止帧未应用。');
    const operation=this.scientificOperation,store=operation?.store??this.deps.store,frame=this.lastReliableFrame;
    if(!frame){this.update({status:'已停止xTB，尚无可靠结构帧，保留原结构。',error:''});return false;}
    if(!this.previewSourceStillCurrent()&&!operation){this.update({status:'已停止xTB，最后可靠结构保留为原任务候选。',error:'',retainedStoppedFrame:structuredClone(frame)});return false;}
    const result={request,frame},current=store.getSnapshot();
    const movable=request.structure.atoms.map(atom=>atom.id!).filter(id=>!request.frozenAtomIds.includes(id));
    const next=applyXtbStoppedCoordinates(this.sourceDocument??current,result,movable);
    const unchanged=coordinatesFingerprint(next.draft.structure)===coordinatesFingerprint(current.draft.structure);
    if(unchanged&&!operation){this.update({status:'已停止xTB，最后可靠结构未变化。',error:''});return false;}
    store.acceptXtbStoppedCoordinates(result,this.sourceDocument);
    if(operation){
      const continuation=structuredClone({options,sourceChain:this.state.sourceChain??[],trajectoryFrames:this.state.trajectoryFrames??[]});
      const run=this.runSettled;
      let disposition:ReturnType<ScientificModelOperation['apply']>|undefined;
      disposition=this.runtimeOwnerCurrent()?operation.apply('xTB停止结果',target=>{
        if(coordinatesFingerprint(target.getSnapshot().draft.structure)===coordinatesFingerprint(next.draft.structure))this.bindContinuation(target,continuation);
        if(disposition==='pending'&&this.runSettled===run)this.update({status:'已停止xTB，最后可靠结构已接管。'});
      }):'retained';
      if(disposition!=='applied'){
        this.update({status:disposition==='pending'?'已停止xTB，最后可靠结构等待接管。':'已停止xTB，最后可靠结构保留为原任务候选。',error:'',retainedStoppedFrame:structuredClone(frame)});return false;
      }
    }
    this.update({status:unchanged?'已停止xTB，最后可靠结构未变化。':'已停止xTB，保留最后可靠结构。',error:'',metadata:undefined});return !unchanged;
  }
  private clearPlayback(error?: Error, retainPreview = false) {
    const playback=this.playback;this.playback=undefined;
    if(playback?.timer!==undefined)clearTimeout(playback.timer);
    if(playback){playback.queue=[];if(error)playback.reject?.(error);}
    if(!retainPreview&&this.state.previewFrame)this.update({previewFrame:undefined});
  }
  private thinPlayback(playback: Playback, maximum: number) {
    const queue=playback.queue;if(queue.length<=maximum)return;
    playback.queue=Array.from({length:maximum},(_,index)=>queue[Math.floor(index*(queue.length-1)/(maximum-1))]);
    this.update({previewSkippedFrames:(this.state.previewSkippedFrames??0)+queue.length-maximum});
  }
  private assertPlaybackCurrent(playback: Playback) {
    const current=this.deps.store.getSnapshot();
    if(this.cancelRequested||this.gone)throw new Error('xTB预览已取消。');
    return current.id===playback.request.stamp.documentId&&this.previewSourceStillCurrent();
  }
  private schedulePlayback(playback: Playback) {
    if(this.playback!==playback||playback.timer!==undefined)return;
    playback.timer=setTimeout(()=>{
      playback.timer=undefined;if(this.playback!==playback)return;
      try {
        if(!this.assertPlaybackCurrent(playback)){playback.resolve?.();this.clearPlayback();return;}
        const frame=playback.queue.shift();
        if(frame)this.update({previewFrame:frame,...(!playback.completed?{status:`${XTB_METHOD_LABELS[playback.request.method]}正在优化 · 原生帧${frame.step}`}:{})});
        else if(playback.completed){playback.resolve?.();playback.resolve=undefined;playback.reject=undefined;return;}
        this.schedulePlayback(playback);
      }catch(error){const failure=error instanceof Error?error:new Error(String(error));this.cancelRequested=true;this.clearPlayback(failure);this.rejectPending?.(failure);}
    },XTB_PLAYBACK_INTERVAL_MS);
  }
  private enqueuePreview(frame: XtbPreviewFrame, request: XtbRequest) {
    if(!this.previewSourceStillCurrent()){this.clearPlayback();return;}
    const playback=this.playback??{sessionId:frame.sessionId,request,queue:[],lastStep:-1,completed:false};
    if(playback.sessionId!==frame.sessionId)throw new Error('xTB播放会话已改变。');
    this.playback=playback;playback.lastStep=frame.step;playback.queue.push(frame);
    const maximum=Math.min(XTB_PLAYBACK_MAX_QUEUED_FRAMES,Math.floor(XTB_PLAYBACK_MAX_QUEUED_COORDINATES/request.structure.atoms.length));
    if(maximum<2)throw new Error('xTB预览原子数量超过有界播放内存。');
    this.thinPlayback(playback,maximum);this.schedulePlayback(playback);
  }
  private finishPlayback(): Promise<void> {
    const playback=this.playback!;playback.completed=true;
    // Reserve a presentation interval for the final real frame. This is a UI
    // delay budget only, never native iteration duration or physical time.
    this.thinPlayback(playback,Math.floor(XTB_PLAYBACK_MAX_TAIL_MS/XTB_PLAYBACK_INTERVAL_MS)-1);
    const drained=new Promise<void>((resolve,reject)=>{playback.resolve=resolve;playback.reject=reject;});
    this.update({phase:'playing',status:'优化已完成，正在播放迭代过程…'});this.schedulePlayback(playback);
    return drained;
  }
  private async perceiveCurrent(mode: BondPerceptionMode, electronic?: {charge:number;multiplicity:number}, evidence?: XtbBondOrders, parameters:EmpiricalBondPerceptionParameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS, candidate?:ModelDocument, operation?:ScientificModelOperation): Promise<ChemistryResult> {
    const store=operation?.store??this.deps.store,current=store.getSnapshot(),structure=structuredClone((candidate??current).draft.structure),fixed=new Set(effectiveModelConstraints(current).frozenAtomIds),ids=structure.atoms.map(atom=>atom.id!).filter(id=>!fixed.has(id));
    if(electronic){structure.charge=electronic.charge;structure.multiplicity=electronic.multiplicity;}
    if(evidence)validateBondOrderEvidence(evidence,structure);
    const stamp=store.stamp(ids);
    this.perceptionDetached=false;
    this.update({workingSource:{documentId:current.id,revision:current.revision},retainedBondResult:undefined});
    store.beginRuntimeSession(this.deps.allowWorkingEdits&&!operation?{isolated:true}:undefined);
    try{
      this.chemistryJob=this.deps.chemistry.start({stamp,operation:'perceive-bonds',structure,movableAtomIds:ids,aggression:'standard',bondPerceptionPolicy:'composite-v1',...(evidence?{bondOrderEvidence:structuredClone(evidence)}:{empiricalBondParameters:validateEmpiricalBondParameters(parameters)})});
      const result=await this.chemistryJob.promise;
      if(!this.deps.allowWorkingEdits&&!operation)this.deps.assertCurrent();
      if(this.cancelRequested||this.gone)throw new Error('成键判断已停止，原连接未替换。');
      const summary=result.bondPerceptionSummary;
      if(result.operation!=='perceive-bonds'||result.bondPerceptionPolicy!=='composite-v1'||!same(result.stamp,stamp)||!same(result.structure.atoms,structure.atoms)||result.structure.charge!==structure.charge||result.structure.multiplicity!==structure.multiplicity||!Array.isArray(result.structure.bonds)||!summary||summary.method!==(evidence?'gfn2-assisted':'empirical')||summary.bondCount!==result.structure.bonds.length||summary.coordinationCount!==result.structure.bonds.filter(bond=>bond.kind==='coordination').length||summary.evidenceCount!==(evidence?.entries.length??0)||!['bondCount','coordinationCount','evidenceCount','conflictCount','rdkitComponentCount','fallbackComponentCount'].every(key=>Number.isSafeInteger(summary[key as keyof typeof summary])&&Number(summary[key as keyof typeof summary])>=0))throw new Error('综合成键结果身份、原子内容或方法回执不匹配。');
      store.finishRuntimeSession();
      const latest=store.getSnapshot();
      if(!operation&&this.deps.allowWorkingEdits&&(!this.runtimeOwnerCurrent()||latest.id!==current.id||latest.revision!==current.revision)){
        this.perceptionDetached=true;this.update({retainedBondResult:structuredClone(result),status:'成键任务完成；工作结构已修改，结果保留在原任务。'});return result;
      }
      // Preoptimization prepares against the accepted candidate before either
      // coordinates or graph are written. The caller commits both together.
      if(candidate)return result;
      const ownTransaction=this.deps.allowWorkingEdits&&!operation;
      if(ownTransaction)store.beginTransaction('成键判断');
      try{store.execute({type:'infer-bonds',mode,aggression:'standard',perceivedBonds:result.structure.bonds,perceivedIssues:result.structure.bondPerceptionIssues,stamp:result.stamp});if(ownTransaction)store.endTransaction();}
      catch(error){if(ownTransaction)store.cancelTransaction();throw error;}
      return result;
    }finally{store.finishRuntimeSession();this.chemistryJob=undefined;}
  }
  async perceiveEmpirical(electronic?: {charge:number;multiplicity:number}, mode:BondPerceptionMode='rebuild', parameters:EmpiricalBondPerceptionParameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS){
    const validated=validateEmpiricalBondParameters(parameters);
    const {store:owner}=this.deps;
    if(this.state.running||owner.hasTransaction?.()||owner.isRuntimeSessionActive?.())throw new Error('请先结束当前编辑或优化。');
    this.deps.assertCurrent();
    const document=owner.getSnapshot(),operation=this.deps.captureSource&&owner.createScientificOperation?.(this.deps.captureSource());
    const store=operation?.store??owner,structure=store.getSnapshot().draft.structure;
    const admission = empiricalBondAdmission(structure); if (admission) throw new Error(admission);
    let settleRun!:()=>void;this.runSettled=new Promise<void>(resolve=>{settleRun=resolve;});
    this.cancelRequested=false;this.perceptionDetached=false;
    this.update({running:true,phase:'bonding',operation:'perceive-bonds',status:'正在按经验判断成键…',error:'',metadata:undefined,retainedBondResult:undefined,workingSource:{documentId:document.id,revision:document.revision}});
    const label='经验判断成键';
    let transaction=false,accepted=false;
    try{
      if(operation)owner.beginRuntimeSession({isolated:true});
      if(operation||!this.deps.allowWorkingEdits||structure.cell?.pbc.some(Boolean)){store.beginTransaction(label);transaction=true;}
      if(this.cancelRequested||this.gone)throw new Error('成键判断已停止，原连接未替换。');
      let receipt:ChemistryResult|undefined,status:string;
      if(structure.cell?.pbc.some(Boolean)){
        const result=perceivePeriodicConnections({...structure,bonds:[]},{parameters:validated,preserveExisting:false,allowUnconfirmedPreview:true});
        store.execute({type:'infer-bonds',mode,aggression:'standard',perceivedBonds:result.bonds,perceivedIssues:result.issues});
        status=structure.cell.pbcProvenance?.kind==='unconfirmed'?'已按来源候选周期轴生成连接预览。':'周期经验成键完成。';
      }else{
        receipt=await this.perceiveCurrent(mode,electronic,undefined,validated,undefined,operation);
        status=receipt.structure.bondPerceptionIssues?.length?'局部连接待确认，其余区域已完成识别。':'经验成键完成。';
      }
      accepted=true;
      if(operation){
        store.endTransaction();transaction=false;
        const run=this.runSettled;
        let disposition:ReturnType<ScientificModelOperation['apply']>|undefined;
        disposition=this.runtimeOwnerCurrent()?operation.apply(label,()=>{
          if(disposition==='pending'&&this.runSettled===run)this.update({status});
        }):'retained';
        if(disposition!=='applied'){
          this.update({status:disposition==='pending'?'成键任务完成，结果等待接管。':'成键任务完成，结果保留在原任务。',retainedBondResult:receipt&&structuredClone(receipt)});return;
        }
      }
      this.update({status});
    }
    catch(error){this.update({status:'',error:error instanceof Error?error.message:String(error)});}
    finally{store.finishRuntimeSession();if(operation)owner.finishRuntimeSession();if(transaction){if(accepted)store.endTransaction();else store.cancelTransaction();}if(this.perceptionDetached)this.update({status:'成键任务完成；工作结构已修改，结果保留在原任务。'});this.update({running:false,phase:'idle'});settleRun();}
  }
  async run(options: XtbOptions, calculation:'optimize'|'singlepoint'='optimize', perceptionMode:BondPerceptionMode='rebuild',observer?:XtbRunObserver,capturedSource?:ModelDocument) {
    if (this.state.running) throw new Error('当前xTB任务尚未结束。');
    const { store:owner, bridge } = this.deps;
    if (!bridge?.startXtb || !bridge.commandXtb || !bridge.onXtbEvent) throw new Error('当前环境没有随包xTB运行入口。');
    this.deps.assertCurrent();
    if (owner.hasTransaction?.()||owner.isRuntimeSessionActive?.()) throw new Error('请先结束当前模型编辑或优化。');
    const singlepoint=calculation==='singlepoint';
    if(options.empiricalBondParameters)validateEmpiricalBondParameters(options.empiricalBondParameters);
    if(singlepoint&&options.method!=='gfn2')throw new Error('辅助成键使用GFN2-xTB。');
    const ownerDocument=owner.getSnapshot();
    if(capturedSource&&(capturedSource.id!==ownerDocument.id||capturedSource.revision!==ownerDocument.revision))throw Error('封存的优化来源已不属于当前文档修订。');
    const operation=(capturedSource||this.deps.captureSource||observer?.deferApplication)&&owner.createScientificOperation?.(capturedSource??(this.continuing||!this.deps.captureSource?ownerDocument:this.deps.captureSource()));
    if(observer?.deferApplication&&!operation)throw Error('当前模型不支持隔离优化结果接管。');
    const store=operation?.store??owner,document=operation?.source??capturedSource??ownerDocument,structure=structuredClone(document.draft.structure);
    if (structure.dimension !== 3 || !structure.atoms.length || structure.periodicSource?.completeness==='partial') throw new Error('xTB预优化需要三维结构及完整晶胞。');
    const periodic=Boolean(structure.cell);
    if(!supportsXtbOperation(options.method,singlepoint?'bond-perception':'optimize',periodic))throw new Error('当前xTB方法不支持此操作或周期条件，请选择适用方法。');
    const solvation=options.solvation===undefined?undefined:structuredClone(options.solvation);
    const solvationIssue=xtbPreoptimizationSolvationIssue(options.method,solvation,periodic);
    if(solvationIssue)throw new Error(solvationIssue);
    const constraints = effectiveModelConstraints(document);
    if(periodic&&!singlepoint&&constraints.coordinates.some(row=>row.images?.some(image=>image.some((component,axis)=>component!==row.images![0][axis]))))throw new Error('周期xTB仅支持同胞B/A/D，请调整跨胞内坐标约束后再运行。');
    if (!singlepoint&&constraints.coordinates.some(row => row.action !== 'freeze')) throw new Error('xTB预优化不执行内坐标扫描。');
    if (!singlepoint&&constraints.coordinates.length && !this.deps.confirmConstraints()) return;
    this.deps.assertCurrent();
    if(owner.getSnapshot().id!==ownerDocument.id||owner.getSnapshot().revision!==ownerDocument.revision)throw new Error('模型或选区已变化，请重新优化。');
    const movable = xtbOptimizationMovableAtomIds(document,singlepoint?'all':options.scope??'all'),movableSet=new Set(movable);
    const frozen = structure.atoms.map(atom=>atom.id!).filter(id=>!movableSet.has(id));
    if (!movable.length&&!singlepoint) throw new Error('当前优化范围没有可动原子；请检查选区及已有冻结。');
    const stamp = store.stamp(movable);
    this.sourceDocument=document;this.ownerDocument=ownerDocument;this.scientificOperation=operation;
    const request: XtbRequest = { stamp, structure, method: options.method, calculation, charge: options.charge,
      ...(options.method==='gfnff'&&options.ffModel?{ffModel:structuredClone(options.ffModel)}:{}),
      ...(options.method === 'gfnff' ? {} : { uhf: options.multiplicity - 1 }),
      ...(solvation ? {solvation} : {}),
      ...(options.maxWallTimeSeconds !== undefined ? { maxWallTimeSeconds: options.maxWallTimeSeconds } : {}),
      frozenAtomIds: frozen, constraints: singlepoint?[]:structuredClone(constraints.coordinates),
      internalConstraintsConfirmed: !singlepoint&&constraints.coordinates.length > 0, maxSteps: options.maxSteps ?? (periodic&&!singlepoint?1000:500), maxSccIterations: options.maxSccIterations ?? 250 };
    this.clearPlayback(); this.cancelRequested = false;this.lastReliableFrame=undefined;this.nativeClosed=false;this.nativeIssued=false;this.stopTask=undefined;
    this.sessionId = crypto.randomUUID();
    const sessionId = this.sessionId;
    const sourceChain=[...(this.continuing?.sourceChain??[]),sessionId],trajectoryFrames=this.continuing?.trajectoryFrames??[];
    this.continuing=undefined;continuations.delete(owner);
    this.update({canContinue:false,sourceChain,trajectoryFrames});
    let settleRun!:()=>void;this.runSettled=new Promise<void>(resolve=>{settleRun=resolve;});
    this.update({ running: true, phase: 'optimizing', operation:calculation, workingSource:{documentId:ownerDocument.id,revision:ownerDocument.revision}, error: '', status: singlepoint?'GFN2-xTB正在计算MBO…':`${XTB_METHOD_LABELS[options.method]}正在优化…`, metadata: undefined, previewFrame:undefined, previewSkippedFrames:0, retainedResult:undefined, retainedStoppedFrame:undefined,retainedBondResult:undefined });
    const label=singlepoint?'GFN2辅助判断成键':'xTB预优化',continuationOptions={...options,solvation,maxSteps:request.maxSteps};
    let transaction=false,accepted=false,lastSequence=-1,stepLimited=false,completedResult:XtbCoordinateResult|undefined,optimizedBonds:ChemistryResult|undefined;
    const adoptStopped=()=>{
      store.finishRuntimeSession();
      if(singlepoint){this.update({status:'已停止GFN2-xTB，原结构未更改。',error:''});return;}
      if(observer?.deferApplication){this.update({status:'优化未完成，原结构和结果已保留。'});return;}
      accepted=this.retainStoppedFrame(request,continuationOptions);
      if(!operation&&(accepted||this.lastReliableFrame&&this.sourceStillCurrent()))this.rememberContinuation(continuationOptions);
    };
    try {
      observer?.onStart(structuredClone(request),sessionId);
      if(!periodic)store.clearBondOrders();
      if(operation){owner.beginRuntimeSession({isolated:true});store.beginRuntimeSession();}
      else if(this.deps.allowWorkingEdits)store.beginRuntimeSession({isolated:true});
      else { store.beginTransaction(label);transaction=true;store.beginRuntimeSession(); }
      const result = await new Promise<XtbCoordinateResult|{stopped:true}>((resolve, reject) => {
        if(this.gone){reject(new Error('xTB运行视图已关闭。'));return;}
        if(this.cancelRequested){resolve({stopped:true});return;}
        this.rejectPending = reject;
        this.unsubscribe = bridge.onXtbEvent!((event: XtbEvent) => {
          if (event.sessionId !== sessionId) return;
          if (this.gone || this.cancelRequested&&!['stopped','completed','error'].includes(event.event)) return;
          try {
            if (event.schema !== 1 || event.operation !== (singlepoint?'xtb-singlepoint':'xtb-optimize') || event.method !== request.method || !same(event.stamp, stamp) || !Number.isSafeInteger(event.seq) || event.seq <= lastSequence) throw new Error('xTB事件身份或顺序不匹配。');
            if (!['started','progress','frame','completed','stopped','error'].includes(event.event)) throw new Error('xTB事件类型无效。');
            lastSequence = event.seq;
            if (event.event === 'frame') {
              const frame=validatePreviewFrame(event,request,this.lastReliableFrame?.step??-1);this.lastReliableFrame=frame;this.update({trajectoryFrames:[...(observer?.deferApplication?[]:this.state.trajectoryFrames??[]),structuredClone(frame)]});this.enqueuePreview(frame,request);
            }
            if (event.event === 'progress' && !this.cancelRequested) this.update({ status: event.status?`${XTB_METHOD_LABELS[options.method]} · ${event.status}`:singlepoint?'GFN2-xTB正在计算MBO…':`${XTB_METHOD_LABELS[options.method]}正在优化${event.step === undefined ? '…' : ` · ${event.step}步`}` });
            if(['started','progress','frame'].includes(event.event))observer?.onEvent?.(event);
            if (event.event === 'error') {
              if(event.exit&&(event.exit.code===null||Number.isSafeInteger(event.exit.code))&&(event.exit.signal===null||typeof event.exit.signal==='string'))this.nativeClosed=true;
              if(event.coordinates){const final=validatePreviewFrame(event,request,-1);if(!this.lastReliableFrame||final.step>=this.lastReliableFrame.step){if(!this.lastReliableFrame||final.step>this.lastReliableFrame.step)this.update({trajectoryFrames:[...(observer?.deferApplication?[]:this.state.trajectoryFrames??[]),structuredClone(final)]});this.lastReliableFrame=final;}}
              stepLimited=event.error?.code==='XTB_STEP_LIMIT'||event.error?.code==='XTB_PERIODIC_STEP_LIMIT';
              reject(new Error(stepLimited?`本轮已达${request.maxSteps}步，尚未收敛；可从最后有效结构继续优化。`:event.error?.message || 'xTB运行失败。'));
            }
            if (event.event === 'stopped') {
              if(!event.exit||!(event.exit.code===null||Number.isSafeInteger(event.exit.code))||!(event.exit.signal===null||typeof event.exit.signal==='string'))throw new Error('xTB停止缺少原生退出确认。');
              if(event.coordinates){const final=validatePreviewFrame(event,request,-1);if(this.lastReliableFrame&&final.step<this.lastReliableFrame.step)throw new Error('xTB停止帧顺序回退。');if(!this.lastReliableFrame||final.step>this.lastReliableFrame.step)this.update({trajectoryFrames:[...(observer?.deferApplication?[]:this.state.trajectoryFrames??[]),structuredClone(final)]});this.lastReliableFrame=final;}
              this.nativeClosed=true;this.cancelRequested=true;resolve({stopped:true});
            }
            if (event.event === 'completed') {
              if (!event.coordinates || !event.metadata || event.exit?.code !== 0 || event.exit.signal !== null) throw new Error('xTB缺少真实成功结果。');
              const completed={request,coordinates:structuredClone(event.coordinates),metadata:structuredClone(event.metadata)};
              // Validate the strict final result before any tail playback. The
              // pure helper does not publish into the authoritative Store.
              if(singlepoint)bondOrderObservation(completed,document.draft.structure,sessionId);
              else applyXtbCoordinates(document,completed,movable);
              this.nativeClosed=true;resolve(this.cancelRequested?{stopped:true}:completed);
            }
          } catch (error) { const failure=error instanceof Error?error:new Error(String(error));this.cancelRequested=true;this.clearPlayback(failure);reject(failure); }
        });
        this.nativeIssued=true;void bridge.startXtb!(request, sessionId).catch(reject);
      });
      this.unsubscribe?.(); this.unsubscribe = undefined; this.rejectPending = undefined; this.sessionId = undefined;
      if('stopped' in result){if(operation)await this.stopAcknowledgement();adoptStopped();return;}
      completedResult=result;
      if(result.metadata.trajectoryWarning)this.clearPlayback(undefined,true);
      else if(this.playback)await this.finishPlayback();
      if (this.cancelRequested || this.gone) throw new Error('xTB结果已取消，未应用坐标。');
      store.finishRuntimeSession();
      if(!operation&&!(singlepoint?this.sourceStillCurrent():this.previewSourceStillCurrent())){this.update({metadata:result.metadata,retainedResult:structuredClone(result),status:'xTB任务完成；工作结构已修改，结果保留在原任务。'});return;}
      let bondFailure:string|undefined;
      if(!singlepoint&&result.metadata.converged&&!periodic&&options.rebuildBonds&&options.method!=='gfnff'){
        this.update({phase:'bonding',status:options.method==='gfn2'?'正在按本次MBO更新成键…':'正在按本次优化坐标进行经验判键…'});
        try{
          const evidence=options.method==='gfn2'?result.metadata.bondOrders:undefined;
          if(options.method==='gfn2'&&!evidence)throw new Error(result.metadata.bondOrdersWarning?.message??'本次GFN2结果没有可用MBO。');
          const candidate=applyXtbCoordinates(this.sourceDocument??store.getSnapshot(),result,movable);
          optimizedBonds=await this.perceiveCurrent('rebuild',{charge:options.charge,multiplicity:options.multiplicity},evidence,options.empiricalBondParameters,candidate,operation);
        }catch(error){bondFailure=error instanceof Error?error.message:String(error);}
        if(this.cancelRequested||this.gone)throw new Error('成键判断已停止，未提交本次结果。');
        if(!operation&&(this.perceptionDetached||!this.previewSourceStillCurrent())){this.update({metadata:result.metadata,retainedResult:structuredClone(result),status:'xTB及成键任务完成；工作结构已修改，结果保留在原任务。'});return;}
      }
      if(!transaction){store.beginTransaction(label);transaction=true;}
      if(singlepoint){
        if(!same(stamp,store.stamp(movable)))throw new Error('MBO结果已不属于当前模型。');
        bondOrderObservation(result,store.getSnapshot().draft.structure,sessionId);
        if(periodic&&options.rebuildBonds&&structure.cell!.pbc.some(Boolean)&&structure.cell!.pbcProvenance?.kind!=='unconfirmed'){
          const perceived=periodicBondOrderConnections(structure,result.metadata.bondOrders!,options.empiricalBondParameters);
          store.execute({type:'infer-bonds',mode:perceptionMode,aggression:'standard',perceivedBonds:perceived.bonds,perceivedIssues:perceived.issues});
        }
      }else {
        store.acceptXtbCoordinates(result,this.sourceDocument,optimizedBonds);
      }
      accepted = true;
      if(this.deps.allowWorkingEdits&&!operation){store.endTransaction();transaction=false;}
      // Keep the final shown native frame until the authoritative final result
      // has committed; do not notify a transient return to the original model.
      if(!operation)this.clearPlayback();
      const converged=result.metadata.converged;
      const resultStatus=singlepoint?'GFN2-xTB单点完成。':converged?`${XTB_METHOD_LABELS[options.method]}优化完成。`:`已达 ${result.metadata.iterations} 步，尚未收敛；已保留结构和能量，可继续优化。`;
      this.update({ metadata: result.metadata, status:resultStatus });
      if(!operation&&!converged)this.rememberContinuation(continuationOptions);
      if(singlepoint&&periodic&&(!structure.cell!.pbc.some(Boolean)||structure.cell!.pbcProvenance?.kind==='unconfirmed'))this.update({status:structure.cell!.pbc.some(Boolean)?'原子对键级已保留；周期轴未确认，未用于连接。':'原子对键级已保留；当前模型无周期轴，未用于连接。'});
      if (!periodic&&options.method === 'gfn2' && singlepoint && options.rebuildBonds) {
        this.update({ phase: 'bonding', status: singlepoint?'正在综合判断成键…':'xTB优化完成，正在重新判断全部成键…' });
        try {
          if(!result.metadata.bondOrders)throw new Error(result.metadata.bondOrdersWarning?.message??'本次GFN2结果没有可用MBO。');
          await this.perceiveCurrent(perceptionMode,{charge:options.charge,multiplicity:options.multiplicity},result.metadata.bondOrders,options.empiricalBondParameters,undefined,operation);
          if(this.perceptionDetached){this.update({retainedResult:structuredClone(result),status:'xTB及成键任务完成；工作结构已修改，结果保留在原任务。'});return;}
          this.update({ status: singlepoint?'MBO分档成键完成（0.5 / 1 / 1.5 / 2 / 3）。':'GFN2-xTB优化及MBO分档成键完成。' });
        } catch (error) {
          this.update({ error: `${singlepoint?'原坐标及连接未替换':'优化坐标已保留，原连接未替换'}：${error instanceof Error ? error.message : String(error)}`, status: singlepoint?'辅助成键未完成。':'xTB优化完成，成键重建未完成。' });
        }
      }
      if(optimizedBonds)this.update({status:options.method==='gfn2'?'GFN2-xTB优化及MBO分档成键完成。':`${XTB_METHOD_LABELS[options.method]}优化及经验判键完成。`});
      if(bondFailure)this.update({error:`优化坐标已保留，原连接未替换：${bondFailure}`,status:'xTB优化完成，成键重建未完成。'});
      if(periodic&&!singlepoint&&options.rebuildBonds)this.update({error:'周期优化未计算辅助原子对键级，原连接已保留。'});
      if(result.metadata.bondOrders&&!this.cancelRequested&&!this.gone){
        if(!operation)this.deps.assertCurrent();
        store.publishBondOrders(result,store.stamp(),sessionId);
      }
      const warning=result.metadata.bondOrdersWarning?.message;
      if(warning&&!this.state.error.includes(warning))this.update({error:this.state.error?`${this.state.error}；${warning}`:warning});
      if(operation){
        if(this.cancelRequested||this.gone)throw new Error('xTB结果接管已取消。');
        store.endTransaction();transaction=false;
        const status=this.state.status,run=this.runSettled;
        let disposition:ReturnType<ScientificModelOperation['apply']>|undefined;
        disposition=observer?.deferApplication?'retained':this.runtimeOwnerCurrent()?operation.apply(label,target=>{
          if(!converged&&coordinatesFingerprint(target.getSnapshot().draft.structure)===coordinatesFingerprint(store.getSnapshot().draft.structure))this.rememberContinuation(continuationOptions,target);
          if(disposition==='pending'&&this.runSettled===run)this.update({status});
        }):'retained';
        if(disposition!=='applied')this.update({retainedResult:structuredClone(result),retainedBondResult:optimizedBonds&&structuredClone(optimizedBonds),status:converged?(disposition==='pending'?'xTB任务完成，结果等待接管。':'xTB任务完成，结果保留在原任务。'):(disposition==='pending'?'xTB达到步数上限，未收敛结果等待接管。':'xTB达到步数上限，未收敛结果保留在原任务。')});
      }
    } catch (error) {
      if(this.nativeClosed&&!accepted&&!singlepoint&&(!operation||stepLimited&&!completedResult)){
        const message=error instanceof Error?error.message:String(error);
        try{adoptStopped();if(!this.cancelRequested)this.update({status:accepted?(stepLimited?'优化未收敛，已保留最后有效结构；可继续优化。':'优化异常结束，已保留最后有效结构。'):operation?this.state.status:'优化未完成。',error:message});}catch(failure){this.update({status:'已停止xTB，停止帧未通过校验，保留原结构。',error:failure instanceof Error?failure.message:String(failure)});}
        return;
      }
      if(this.sessionId&&this.nativeIssued&&!this.nativeClosed)this.stopTask??=bridge.commandXtb(this.sessionId,{command:'stop'}).catch(()=>{});
      if(operation&&completedResult)this.update({metadata:completedResult.metadata,retainedResult:structuredClone(completedResult),retainedBondResult:optimizedBonds&&structuredClone(optimizedBonds),error:this.cancelRequested?'':error instanceof Error?error.message:String(error),status:'xTB任务完成，结果保留在原任务。'});
      else this.update({ error: error instanceof Error ? error.message : String(error), status: accepted&&!singlepoint ? '已保留优化坐标。' : '' });
    } finally {
      this.clearPlayback();
      this.unsubscribe?.(); this.unsubscribe = undefined; this.rejectPending = undefined; this.sessionId = undefined;
      await this.stopAcknowledgement()?.catch(()=>{});
      store.finishRuntimeSession();
      if (transaction) { if (accepted) store.endTransaction(); else store.cancelTransaction(); }
      if(operation)owner.finishRuntimeSession();
      observer?.onSettled({request:structuredClone(request),sessionId,status:completedResult&&!(observer?.deferApplication&&this.cancelRequested)?'completed':this.cancelRequested&&!this.state.error?'stopped':'failed',
        frames:structuredClone(this.state.trajectoryFrames??[]),...(completedResult?{result:structuredClone(completedResult)}:{}),
        ...(observer?.deferApplication&&accepted?{document:structuredClone(store.getSnapshot())}:{}),...(this.state.error?{error:this.state.error}:{})});
      if(observer?.deferApplication)this.update({trajectoryFrames:[],previewFrame:undefined});
      this.scientificOperation=undefined;this.lastReliableFrame=undefined;this.update({ running: false, phase: 'idle' });settleRun();
    }
  }
}
